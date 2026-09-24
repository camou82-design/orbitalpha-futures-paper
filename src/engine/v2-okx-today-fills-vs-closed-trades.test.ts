import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import {
  normalizeOkxRawFills,
  filterTodayKstRawFills,
  normalizePositionsHistoryArray,
  type NormalizedOkxRawFill
} from "../lib/paperClosedHistoryNormalize";
import { buildLedgerPerformanceFromHistory } from "../lib/futuresPaperLedgerStats";
import { reconstructLifecyclesFromFills } from "../lib/okxLifecycleReconstruction";
import { isStrategyStatsRow } from "../engine-v2/lifecycle/completed-trade";
import { composePublicFuturesPaperBundleForWrite } from "../lib/futuresPaperBundleCore";
import { saveOkxRawFills, saveOkxAccountClosedTrades } from "../storage/account-truth-store";

test("V2 OKX Today Fills vs Today Closed Trades Suite (9/23 Audit Fixture & UI Consumer Proof)", async (t) => {
  // 9/23 KST Reference Timestamp (2026-09-23 23:59:00 KST = 2026-09-23 14:59:00 UTC)
  const refTimeSep23Kst = Date.UTC(2026, 8, 23, 14, 59, 0, 0);
  // 9/24 KST Reference Timestamp (2026-09-24 01:30:00 KST = 2026-09-23 16:30:00 UTC)
  const refTimeSep24Kst = Date.UTC(2026, 8, 23, 16, 30, 0, 0);

  // 9/23 OKX Raw Fills Fixture (Exact 7 Fills from Audit)
  const sep23AuditRawFills = [
    {
      instId: "BTC-USDT-SWAP",
      side: "buy",
      posSide: "net",
      fillSz: "1",
      fillPx: "63850.5",
      tradeId: "784910283",
      ordId: "28491028301",
      clOrdId: "v2_btc_e1",
      fillTime: Date.UTC(2026, 8, 23, 1, 14, 22, 0) // 10:14:22 KST
    },
    {
      instId: "BTC-USDT-SWAP",
      side: "sell",
      posSide: "net",
      fillSz: "0.5",
      fillPx: "64120.0",
      tradeId: "784923841",
      ordId: "28492384109",
      clOrdId: "tppos_btc_tp1",
      fillTime: Date.UTC(2026, 8, 23, 2, 30, 5, 0), // 11:30:05 KST
      fillPnl: "134.75",
      fee: "1.92"
    },
    {
      instId: "BTC-USDT-SWAP",
      side: "sell",
      posSide: "net",
      fillSz: "0.5",
      fillPx: "64350.0",
      tradeId: "784950192",
      ordId: "28495019244",
      clOrdId: "slpos_btc_close",
      fillTime: Date.UTC(2026, 8, 23, 4, 45, 18, 0), // 13:45:18 KST
      fillPnl: "249.75",
      fee: "1.93"
    },
    {
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "net",
      fillSz: "2",
      fillPx: "2650.2",
      tradeId: "784981920",
      ordId: "28498192033",
      clOrdId: "v2_eth_e1",
      fillTime: Date.UTC(2026, 8, 23, 6, 20, 10, 0) // 15:20:10 KST
    },
    {
      instId: "ETH-USDT-SWAP",
      side: "buy",
      posSide: "net",
      fillSz: "2",
      fillPx: "2632.0",
      tradeId: "785012399",
      ordId: "28501239912",
      clOrdId: "tppos_eth_close",
      fillTime: Date.UTC(2026, 8, 23, 7, 5, 44, 0), // 16:05:44 KST
      fillPnl: "36.4",
      fee: "1.06"
    },
    {
      instId: "ETH-USDT-SWAP",
      side: "buy",
      posSide: "net",
      fillSz: "1",
      fillPx: "2640.0",
      tradeId: "785055102",
      ordId: "28505510201",
      clOrdId: "v2_eth_e2",
      fillTime: Date.UTC(2026, 8, 23, 9, 10, 0, 0) // 18:10:00 KST
    },
    {
      instId: "ETH-USDT-SWAP",
      side: "sell",
      posSide: "net",
      fillSz: "0.5",
      fillPx: "2665.0",
      tradeId: "785088214",
      ordId: "28508821455",
      clOrdId: "tppos_eth_tp1",
      fillTime: Date.UTC(2026, 8, 23, 10, 22, 15, 0), // 19:22:15 KST
      fillPnl: "12.5",
      fee: "0.53"
    }
  ];

  await t.test("1. 9/23 OKX raw fills normalization yields exactly 7 fills with distinct fill roles", () => {
    const normalized = normalizeOkxRawFills(sep23AuditRawFills);
    assert.equal(normalized.length, 7, "Total raw fills must be 7");

    const todayFills = filterTodayKstRawFills(normalized, refTimeSep23Kst);
    assert.equal(todayFills.length, 7, "Today KST fills on 9/23 must be 7");

    // Check tradeId deduplication
    const tradeIds = todayFills.map((f) => f.tradeId);
    assert.equal(new Set(tradeIds).size, 7, "All tradeIds must be unique");

    // Verify fill roles and source attribution
    const btcEntry = todayFills.find((f) => f.tradeId === "784910283");
    assert.ok(btcEntry);
    assert.equal(btcEntry.symbol, "BTCUSDT");
    assert.equal(btcEntry.sourceLabel, "자동");
    assert.equal(btcEntry.fillTypeLabel, "진입");
    assert.equal(btcEntry.fillRole, "ENTRY");

    const btcTp1 = todayFills.find((f) => f.tradeId === "784923841");
    assert.ok(btcTp1);
    assert.equal(btcTp1.sourceLabel, "자동");
    assert.equal(btcTp1.fillTypeLabel, "부분청산");
    assert.equal(btcTp1.fillRole, "PARTIAL_EXIT");

    const btcFullClose = todayFills.find((f) => f.tradeId === "784950192");
    assert.ok(btcFullClose);
    assert.equal(btcFullClose.sourceLabel, "자동");
    assert.equal(btcFullClose.fillTypeLabel, "청산완료");
    assert.equal(btcFullClose.fillRole, "FULL_EXIT");

    const ethEntry1 = todayFills.find((f) => f.tradeId === "784981920");
    assert.ok(ethEntry1);
    assert.equal(ethEntry1.symbol, "ETHUSDT");
    assert.equal(ethEntry1.fillTypeLabel, "진입");

    const ethClose1 = todayFills.find((f) => f.tradeId === "785012399");
    assert.ok(ethClose1);
    assert.equal(ethClose1.fillTypeLabel, "청산완료");

    const ethEntry2 = todayFills.find((f) => f.tradeId === "785055102");
    assert.ok(ethEntry2);
    assert.equal(ethEntry2.fillTypeLabel, "진입");

    const ethTp1 = todayFills.find((f) => f.tradeId === "785088214");
    assert.ok(ethTp1);
    assert.equal(ethTp1.fillTypeLabel, "부분청산");
  });

  await t.test("2. Date boundary check: 9/24 KST evaluation correctly separates 9/23 vs 9/24 fills", () => {
    const sep24Fill = {
      instId: "BTC-USDT-SWAP",
      side: "buy",
      posSide: "net",
      fillSz: "0.8",
      fillPx: "64500",
      tradeId: "786000001",
      ordId: "28600000101",
      clOrdId: "v2_btc_sep24_e1",
      fillTime: Date.UTC(2026, 8, 23, 16, 5, 0, 0) // 2026-09-24 01:05:00 KST
    };

    const combinedFills = [...sep23AuditRawFills, sep24Fill];
    const normalized = normalizeOkxRawFills(combinedFills);
    assert.equal(normalized.length, 8);

    // On 9/24 KST, todayRawFills must contain ONLY 9/24 fills
    const todayFillsSep24 = filterTodayKstRawFills(normalized, refTimeSep24Kst);
    assert.equal(todayFillsSep24.length, 1);
    assert.equal(todayFillsSep24[0].tradeId, "786000001");
    assert.equal(todayFillsSep24[0].fillTypeLabel, "진입");

    // On 9/23 KST, todayRawFills must contain ONLY 9/23 fills
    const todayFillsSep23 = filterTodayKstRawFills(normalized, refTimeSep23Kst);
    assert.equal(todayFillsSep23.length, 7);
  });

  await t.test("3. Lifecycle reconstruction from the 7 fills yields exactly 2 completed closed trades", () => {
    const closedLifecycles = reconstructLifecyclesFromFills(sep23AuditRawFills);
    assert.equal(closedLifecycles.length, 2, "Only 2 lifecycles reached flat state (currentQty == 0)");

    // Closed Trade 1: BTC (Entry 1 -> TP1 0.5 -> Full Close 0.5)
    const btcTrade = closedLifecycles.find((t) => t.symbol === "BTCUSDT");
    assert.ok(btcTrade);
    assert.equal(btcTrade.side, "long");
    assert.equal(btcTrade.entryQty, 1);
    assert.equal(btcTrade.closedQty, 1);
    assert.equal(btcTrade.sourceLabel, "자동");

    // Closed Trade 2: ETH (Entry 2 -> Full Close 2)
    const ethTrade = closedLifecycles.find((t) => t.symbol === "ETHUSDT");
    assert.ok(ethTrade);
    assert.equal(ethTrade.side, "short");
    assert.equal(ethTrade.entryQty, 2);
    assert.equal(ethTrade.closedQty, 2);
    assert.equal(ethTrade.sourceLabel, "자동");
  });

  await t.test("4. Daily stats & ledger performance are strictly computed on completed trades (2 trades, never 7)", () => {
    const closedLifecycles = reconstructLifecyclesFromFills(sep23AuditRawFills);
    const normalizedClosedHistory = normalizePositionsHistoryArray(closedLifecycles);
    assert.equal(normalizedClosedHistory.length, 2);

    const perf = buildLedgerPerformanceFromHistory(normalizedClosedHistory, refTimeSep23Kst);

    // Account today total trades must be 2
    assert.equal(perf.today.totalTrades, 2, "Today completed trades count must be 2");
    assert.equal(perf.strategy.today.totalTrades, 2, "Strategy today completed trades count must be 2");

    // All trades are BOT_V2
    assert.equal(isStrategyStatsRow(closedLifecycles[0]), true);
    assert.equal(isStrategyStatsRow(closedLifecycles[1]), true);
  });

  await t.test("5. Operating Bundle composition proof: composePublicFuturesPaperBundleForWrite supplies todayRawFills", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-raw-fills-test-"));
    const dataDir = path.join(tmpDir, "data");
    await fs.mkdir(path.join(dataDir, "reports"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "snapshots"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "positions"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "account-truth"), { recursive: true });

    // Save raw fills & closed trades
    await saveOkxRawFills(dataDir, sep23AuditRawFills as any);
    const closedLifecycles = reconstructLifecyclesFromFills(sep23AuditRawFills);
    await saveOkxAccountClosedTrades(dataDir, closedLifecycles);

    const bundle = await composePublicFuturesPaperBundleForWrite({
      projectRoot: tmpDir,
      summary: {},
      summaryRange: {},
      summaryTrend: {},
      summaryDaily: {},
      summaryWindow: {},
      summaryHealth: {},
      dashboard: {},
      positionsHistoryRaw: [],
      eventsParsed: [],
      healthHistoryParsed: []
    });

    assert.ok(bundle);
    assert.ok(Array.isArray(bundle.rawFills), "bundle.rawFills must be an array");
    assert.equal(bundle.rawFills.length, 7, "bundle.rawFills must contain 7 fills");
    assert.ok(Array.isArray(bundle.todayRawFills), "bundle.todayRawFills must be an array");
    assert.ok(Array.isArray(bundle.positionsHistory), "bundle.positionsHistory must be an array");
    assert.equal(bundle.positionsHistory.length, 2, "bundle.positionsHistory must contain 2 closed trades");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await t.test("6. UI Consumer Rendering Simulation Proof: todayRawFills renders distinct 7-row table with badges and roles", () => {
    // Simulate what renderTodayRawFills() does inside monitor.js
    const normalized = normalizeOkxRawFills(sep23AuditRawFills);
    const bundleMock = {
      todayRawFills: filterTodayKstRawFills(normalized, refTimeSep23Kst),
      positionsHistory: reconstructLifecyclesFromFills(sep23AuditRawFills)
    };

    assert.equal(bundleMock.todayRawFills.length, 7);
    assert.equal(bundleMock.positionsHistory.length, 2);

    // Verify all table data fields exist and match expected values
    for (const fill of bundleMock.todayRawFills) {
      assert.ok(fill.fillTimeKst.includes("KST"), "Must have formatted KST timestamp");
      assert.ok(fill.symbol === "BTCUSDT" || fill.symbol === "ETHUSDT");
      assert.ok(fill.side === "buy" || fill.side === "sell");
      assert.ok(Number(fill.fillSz) > 0);
      assert.ok(Number(fill.fillPx) > 0);
      assert.equal(fill.sourceLabel, "자동");
      assert.ok(["진입", "부분청산", "청산완료"].includes(fill.fillTypeLabel));
      assert.ok(fill.tradeId.length > 0);
    }
  });

  await t.test("7. UI Fallback Safety: When todayRawFills is missing, rawFills fallback filters strictly by KST today without past leaks", () => {
    const kstOffset = 9 * 3600 * 1000;
    function startOfKstDay(nowMs: number): number {
      const d = new Date(nowMs + kstOffset);
      const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
      return midnightUtc - kstOffset;
    }

    const pastFill = {
      instId: "BTC-USDT-SWAP",
      side: "buy",
      fillSz: "1",
      fillPx: "60000",
      tradeId: "tid_past_01",
      ordId: "ord_past_01",
      fillTime: Date.UTC(2026, 8, 20, 10, 0, 0, 0) // 3 days ago
    };
    const todayFill = {
      instId: "BTC-USDT-SWAP",
      side: "sell",
      fillSz: "1",
      fillPx: "65000",
      tradeId: "tid_today_01",
      ordId: "ord_today_01",
      fillTime: Date.UTC(2026, 8, 23, 10, 0, 0, 0) // 9/23 KST
    };

    const bundleWithoutTodayFills = {
      todayRawFills: undefined,
      rawFills: normalizeOkxRawFills([pastFill, todayFill]),
      generatedAt: refTimeSep23Kst
    };

    // Simulate monitor.js fallback logic
    const resolvedList = (() => {
      if (Array.isArray(bundleWithoutTodayFills.todayRawFills)) {
        return bundleWithoutTodayFills.todayRawFills;
      }
      if (Array.isArray(bundleWithoutTodayFills.rawFills) && bundleWithoutTodayFills.rawFills.length > 0) {
        const nowMs = bundleWithoutTodayFills.generatedAt;
        const kstStart = startOfKstDay(nowMs);
        const kstEnd = kstStart + 24 * 3600 * 1000;
        return bundleWithoutTodayFills.rawFills.filter((f) => {
          const t = Number(f && f.fillTime) || 0;
          return t >= kstStart && t < kstEnd;
        });
      }
      return [];
    })();

    assert.equal(resolvedList.length, 1, "Must contain ONLY 1 today fill, 0 past fills");
    assert.equal(resolvedList[0].tradeId, "tid_today_01");
  });

  await t.test("8. Regression Proof: Today raw fills BTC/ETH split rendering with independent top 5 and multiple fills per order", () => {
    // Generate 8 BTC fills and 20 ETH fills
    const baseTime = Date.UTC(2026, 8, 23, 1, 0, 0, 0);
    const btcFillsRaw = Array.from({ length: 8 }, (_, i) => ({
      instId: "BTC-USDT-SWAP",
      side: i % 2 === 0 ? "buy" : "sell",
      fillSz: "0.5",
      fillPx: `${64000 + i * 100}`,
      tradeId: `btc_tid_${i + 1}`,
      ordId: i < 2 ? "shared_btc_ord_1" : `btc_ord_${i + 1}`, // First 2 fills share the same ordId (multiple fills)
      clOrdId: i % 2 === 0 ? `v2_btc_e${i + 1}` : `tppos_btc_${i + 1}`,
      fillTime: baseTime + i * 60000,
      fillPnl: i % 2 === 1 ? `${50 + i * 10}` : undefined,
      fee: "1.5"
    }));

    const ethFillsRaw = Array.from({ length: 20 }, (_, i) => ({
      instId: "ETH-USDT-SWAP",
      side: i % 2 === 0 ? "buy" : "sell",
      fillSz: "2",
      fillPx: `${2600 + i * 10}`,
      tradeId: `eth_tid_${i + 1}`,
      ordId: `eth_ord_${i + 1}`,
      clOrdId: i % 3 === 0 ? undefined : `v2_eth_${i + 1}`, // Some manual fills
      fillTime: baseTime + i * 60000 + 30000,
      fillPnl: i % 2 === 1 ? `${20 + i * 2}` : undefined,
      fee: "0.8"
    }));

    const normalizedAll = normalizeOkxRawFills([...btcFillsRaw, ...ethFillsRaw]);
    assert.equal(normalizedAll.length, 28, "Total raw fills must be 28");

    // Verify multiple fills from same ordId both exist
    const multiFills = normalizedAll.filter((f) => f.ordId === "shared_btc_ord_1");
    assert.equal(multiFills.length, 2, "Both fills of shared order must be preserved");
    assert.notEqual(multiFills[0].tradeId, multiFills[1].tradeId, "TradeIds must be distinct");

    // Simulate BTC/ETH independent split and slice(0, 5)
    const isBtc = (sym: string) => String(sym).toUpperCase().includes("BTC");
    const isEth = (sym: string) => String(sym).toUpperCase().includes("ETH");

    const btcFills = normalizedAll
      .filter((f) => isBtc(f.symbol || f.instId))
      .sort((a, b) => b.fillTime - a.fillTime)
      .slice(0, 5);

    const ethFills = normalizedAll
      .filter((f) => isEth(f.symbol || f.instId))
      .sort((a, b) => b.fillTime - a.fillTime)
      .slice(0, 5);

    assert.equal(btcFills.length, 5, "BTC must have exactly 5 latest fills");
    assert.equal(ethFills.length, 5, "ETH must have exactly 5 latest fills");

    // Verify descending order
    for (let i = 0; i < btcFills.length - 1; i++) {
      assert.ok(btcFills[i].fillTime >= btcFills[i + 1].fillTime, "BTC fills must be sorted descending");
    }
    for (let i = 0; i < ethFills.length - 1; i++) {
      assert.ok(ethFills[i].fillTime >= ethFills[i + 1].fillTime, "ETH fills must be sorted descending");
    }

    // Edge case: When 0 BTC fills exist, BTC list is empty (0) and ETH still displays top 5
    const ethOnlyNormalized = normalizeOkxRawFills(ethFillsRaw);
    const btcEmpty = ethOnlyNormalized
      .filter((f) => isBtc(f.symbol || f.instId))
      .sort((a, b) => b.fillTime - a.fillTime)
      .slice(0, 5);
    const ethOnly5 = ethOnlyNormalized
      .filter((f) => isEth(f.symbol || f.instId))
      .sort((a, b) => b.fillTime - a.fillTime)
      .slice(0, 5);

    assert.equal(btcEmpty.length, 0, "BTC must be empty 0 when no BTC fills exist");
    assert.equal(ethOnly5.length, 5, "ETH must still display top 5");
  });

  await t.test("9. Regression Proof: Recent closed trades BTC/ETH split must filter by symbol BEFORE slice(0, 5) to prevent starvation", () => {
    const baseClosedAt = Date.UTC(2026, 8, 23, 10, 0, 0, 0);

    // 8 BTC closed trades and 20 ETH closed trades
    const btcClosedTrades = Array.from({ length: 8 }, (_, i) => ({
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 64000,
      closePrice: 64500,
      openedAt: baseClosedAt - 3600000 - i * 100000,
      closedAt: baseClosedAt + i * 60000, // BTC closed between 10:00 and 10:07
      realizedPnlUsd: 150 + i * 10,
      feeUsd: 2.0,
      exitReason: "take_profit",
      sourceLabel: "자동",
      status: "closed"
    }));

    const ethClosedTrades = Array.from({ length: 20 }, (_, i) => ({
      symbol: "ETHUSDT",
      side: "short",
      entryPrice: 2650,
      closePrice: 2620,
      openedAt: baseClosedAt - 3600000 - i * 100000,
      closedAt: baseClosedAt + 600000 + i * 60000, // ETH closed LATER (between 10:10 and 10:30)
      realizedPnlUsd: 40 + i * 5,
      feeUsd: 1.0,
      exitReason: "take_profit",
      sourceLabel: i % 2 === 0 ? "자동" : "수동",
      status: "closed"
    }));

    const allPositionsHistory = [...btcClosedTrades, ...ethClosedTrades];

    // WRONG pattern (Buggy): sort all descending then slice(0, 10) then filter -> BTC would be completely starved!
    const buggyAllSlice = [...allPositionsHistory]
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 10);
    const starvedBtc = buggyAllSlice.filter((r) => r.symbol === "BTCUSDT");
    assert.equal(starvedBtc.length, 0, "Demonstration: Naive slice(0, 10) first starves BTC completely");

    // CORRECT pattern (Canonical UI logic): filter by symbol FIRST, then sort and slice(0, 5)
    const isBtc = (sym: string) => String(sym).toUpperCase().includes("BTC");
    const isEth = (sym: string) => String(sym).toUpperCase().includes("ETH");

    const canonicalBtc = allPositionsHistory
      .filter((r) => isBtc(r.symbol))
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 5);

    const canonicalEth = allPositionsHistory
      .filter((r) => isEth(r.symbol))
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 5);

    assert.equal(canonicalBtc.length, 5, "BTC must have 5 closed trades");
    assert.equal(canonicalEth.length, 5, "ETH must have 5 closed trades");
    assert.equal(canonicalBtc[0].closedAt, baseClosedAt + 7 * 60000, "BTC must have latest closedAt");
    assert.equal(canonicalEth[0].closedAt, baseClosedAt + 600000 + 19 * 60000, "ETH must have latest closedAt");

    // Verify sourceLabel preservation
    assert.equal(canonicalBtc[0].sourceLabel, "자동");
    assert.ok(["자동", "수동"].includes(canonicalEth[0].sourceLabel));
  });
});
