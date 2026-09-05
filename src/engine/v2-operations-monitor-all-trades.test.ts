import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDisplayTradeSourceLabel,
  normalizeClosedHistoryRow,
  displayFieldsForClosedRow,
  type NormalizedPaperClosedRow
} from "../lib/paperClosedHistoryNormalize";
import { deriveCurrentPositionsForDisplay } from "../lib/futuresPaperBundleCore";
import { buildLedgerPerformanceFromHistory } from "../lib/futuresPaperLedgerStats";
import { buildPaperWindowSummaryFromHistory } from "../storage/paper-summary";

test("PHASE 13: Operations Monitor All Trades — 14 Mandatory Tests", async (t) => {
  // 1. BOT trade 표시
  await t.test("1. BOT trade is labeled as '자동'", () => {
    const botRow = {
      symbol: "BTCUSDT",
      side: "long",
      source: "v2",
      authority: "ENGINE",
      flowId: "flow-btc-1",
      closeSource: "BOT_STRATEGY",
      closeReason: "tp1_hit"
    };
    const label = resolveDisplayTradeSourceLabel(botRow);
    assert.equal(label, "자동");

    const norm = normalizeClosedHistoryRow(botRow);
    assert.equal(norm.sourceLabel, "자동");
  });

  // 2. MANUAL trade 표시
  await t.test("2. MANUAL trade is labeled as '수동'", () => {
    const manualRow = {
      symbol: "BTCUSDT",
      side: "short",
      source: "manual",
      authority: "MANUAL",
      closeSource: "MANUAL_EXTERNAL",
      closeReason: "manual_market_close"
    };
    const label = resolveDisplayTradeSourceLabel(manualRow);
    assert.equal(label, "수동");

    const norm = normalizeClosedHistoryRow(manualRow);
    assert.equal(norm.sourceLabel, "수동");
  });

  // 3. ADOPTED_EXTERNAL 표시
  await t.test("3. ADOPTED_EXTERNAL trade is labeled as '외부포지션 인계'", () => {
    const adoptedRow = {
      symbol: "ETHUSDT",
      side: "long",
      source: "ADOPTED_EXTERNAL",
      authority: "ADOPTED_EXTERNAL",
      adoptedFrom: "okx_manual",
      closeSource: "UNKNOWN",
      closeReason: "manual_external_close"
    };
    const label = resolveDisplayTradeSourceLabel(adoptedRow);
    assert.equal(label, "외부포지션 인계");

    const norm = normalizeClosedHistoryRow(adoptedRow);
    assert.equal(norm.sourceLabel, "외부포지션 인계");
  });

  // 4. OPERATOR_MANAGED 표시
  await t.test("4. OPERATOR_MANAGED trade is labeled as '수동관리'", () => {
    const opRow = {
      symbol: "ETHUSDT",
      side: "short",
      source: "OPERATOR_MANAGED",
      authority: "OPERATOR_MANAGED",
      closeSource: "OPERATOR",
      closeReason: "operator_takeover_close"
    };
    const label = resolveDisplayTradeSourceLabel(opRow);
    assert.equal(label, "수동관리");

    const norm = normalizeClosedHistoryRow(opRow);
    assert.equal(norm.sourceLabel, "수동관리");
  });

  // 5. 자동진입→수동청산 표시
  await t.test("5. Hybrid Bot Entry + Manual Exit is labeled as '자동→수동'", () => {
    const hybridRow = {
      symbol: "BTCUSDT",
      side: "long",
      source: "v2",
      strategy: "v2",
      flowId: "flow-auto-1",
      closeSource: "MANUAL_EXTERNAL",
      closeReason: "user_emergency_exit"
    };
    const label = resolveDisplayTradeSourceLabel(hybridRow);
    assert.equal(label, "자동→수동");

    const fields = displayFieldsForClosedRow(hybridRow);
    assert.equal(fields.sourceLabel, "자동→수동");
  });

  // 6. 수동진입→자동청산 표시
  await t.test("6. Hybrid Manual Entry + Bot Exit is labeled as '수동→자동'", () => {
    const hybridRow = {
      symbol: "ETHUSDT",
      side: "short",
      source: "manual",
      entrySource: "manual",
      authority: "MANUAL",
      closeSource: "BOT_STRATEGY",
      closeReason: "take_profit"
    };
    const label = resolveDisplayTradeSourceLabel(hybridRow);
    assert.equal(label, "수동→자동");

    const fields = displayFieldsForClosedRow(hybridRow);
    assert.equal(fields.sourceLabel, "수동→자동");
  });

  // 7. flowId 없는 manual 거래도 표시
  await t.test("7. Manual trade without flowId is preserved and displayed", () => {
    const manualWithoutFlowId = {
      symbol: "BTCUSDT",
      side: "long",
      source: "manual",
      entryPrice: 65000,
      closePrice: 66000,
      pnlUsdNet: 100,
      feeUsd: 5
    };
    const norm = normalizeClosedHistoryRow(manualWithoutFlowId);
    assert.equal(norm.sourceLabel, "수동");
    assert.equal(norm.realizedPnlUsd, 100);

    const fields = displayFieldsForClosedRow(norm);
    assert.equal(fields.sourceLabel, "수동");
    assert.equal(fields.closePriceLabel, "66,000");
  });

  // 8. 같은 거래 bot+exchange 중복 제거 (Dedup)
  await t.test("8. Current position dedup: bot ledger row and OKX preview row are merged into 1 row", () => {
    const openPositions = [
      {
        symbol: "BTCUSDT",
        side: "long",
        status: "open",
        entryPrice: 65000,
        source: "v2",
        authority: "ENGINE"
      }
    ];
    const engineState = {
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: true,
      ledger_okx_position_sync: {
        okx_positions_preview: [
          {
            symbol: "BTCUSDT",
            side: "long",
            pos: 1,
            notionalUsd: 65000,
            upl: 250,
            instId: "BTC-USDT-SWAP"
          }
        ]
      }
    };

    const currentPositions = deriveCurrentPositionsForDisplay(engineState, openPositions);
    assert.equal(currentPositions.length, 1, "Must not duplicate same BTCUSDT position");
    const merged = currentPositions[0] as Record<string, unknown>;
    assert.equal(merged.symbol, "BTCUSDT");
    assert.equal(merged.side, "long");
    assert.equal(merged.entryPrice, 65000);
    assert.equal(merged.okxPositionContracts, 1);
    assert.equal(merged.unrealizedPnl, 250);
    assert.equal(merged.sourceLabel, "자동");
  });

  // 9. partial fills lifecycle 1건 집계
  await t.test("9. Partial fills (isChildExecution: true) are not double counted in summary", () => {
    const history = [
      // Full position 1 lifecycle
      {
        symbol: "BTCUSDT",
        side: "long",
        pnlUsdNet: 50,
        pnlUsdGross: 52,
        feeUsd: 2,
        fundingUsd: 0,
        closedAt: Date.now() - 1000,
        tradeSource: "BOT_V2",
        isPositionCycleFinal: true
      },
      // Child execution 1 (partial TP1) - should not count as separate trade
      {
        symbol: "ETHUSDT",
        side: "short",
        pnlUsdNet: 20,
        pnlUsdGross: 21,
        feeUsd: 1,
        fundingUsd: 0,
        closedAt: Date.now() - 2000,
        tradeSource: "BOT_V2",
        isChildExecution: true,
        closeReason: "partial_exit_1"
      },
      // Full position 2 lifecycle final
      {
        symbol: "ETHUSDT",
        side: "short",
        pnlUsdNet: 40,
        pnlUsdGross: 42,
        feeUsd: 2,
        fundingUsd: 0,
        closedAt: Date.now() - 500,
        tradeSource: "BOT_V2",
        isPositionCycleFinal: true
      }
    ];

    const perf = buildLedgerPerformanceFromHistory(history);
    // Only the 2 final position cycles should be counted
    assert.equal(perf.all.totalTrades, 2, "Partial fill must not increase trade count to 3");
    assert.equal(perf.all.totalPnlUsdNet, 90);
  });

  // 10. current manual open position 표시
  await t.test("10. Current manual open position on OKX is always visible even if missing from paper ledger", () => {
    const openPositions: unknown[] = []; // empty ledger!
    const engineState = {
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: true,
      ledger_okx_position_sync: {
        okx_positions_preview: [
          {
            symbol: "BTCUSDT",
            side: "short",
            pos: 2,
            notionalUsd: 130000,
            upl: -120,
            instId: "BTC-USDT-SWAP"
          }
        ]
      }
    };

    const currentPositions = deriveCurrentPositionsForDisplay(engineState, openPositions);
    assert.equal(currentPositions.length, 1, "Manual OKX position must appear in display");
    const pos = currentPositions[0] as Record<string, unknown>;
    assert.equal(pos.symbol, "BTCUSDT");
    assert.equal(pos.side, "short");
    assert.equal(pos.sourceLabel, "수동");
    assert.equal(pos.authority, "MANUAL");
    assert.equal(pos.okxPositionContracts, 2);
  });

  // 11. PnL / fee 보존
  await t.test("11. Summary correctly aggregates PnL and fees across Auto and Manual trades", () => {
    const now = Date.now();
    const history = [
      {
        symbol: "BTCUSDT",
        side: "long",
        pnlUsdNet: 100,
        pnlUsdGross: 105,
        feeUsd: 5,
        fundingUsd: 0,
        closedAt: now - 1000,
        tradeSource: "BOT_V2",
        isPositionCycleFinal: true
      },
      {
        symbol: "ETHUSDT",
        side: "short",
        pnlUsdNet: -40,
        pnlUsdGross: -35,
        feeUsd: 5,
        fundingUsd: 0,
        closedAt: now - 2000,
        tradeSource: "MANUAL_EXTERNAL",
        isPositionCycleFinal: true
      }
    ];

    const perf = buildLedgerPerformanceFromHistory(history, now);
    // Overall account includes both
    assert.equal(perf.all.totalTrades, 2);
    assert.equal(perf.all.totalPnlUsdNet, 60);
    assert.equal(perf.all.totalFeeUsd, 10);
    assert.equal(perf.all.winTrades, 1);
    assert.equal(perf.all.lossTrades, 1);

    // Strategy-specific breakdown preserves bot-only numbers
    assert.equal(perf.strategy.all.totalTrades, 1);
    assert.equal(perf.strategy.all.totalPnlUsdNet, 100);

    // Window summary report check
    const winReport = buildPaperWindowSummaryFromHistory(history, now);
    assert.equal(winReport.windows.all.totalTrades, 2);
    assert.equal(winReport.strategyWindows.all.totalTrades, 1);
    assert.equal(winReport.accountWindows.all.totalTrades, 2);
  });

  // 12. 기존 automatic trade 표시 회귀 없음
  await t.test("12. Automatic trades retain all original fields without regression", () => {
    const rawBot = {
      symbol: "ETHUSDT",
      side: "long",
      source: "v2",
      strategy: "RANGE",
      regime: "RANGE",
      entryPrice: 3000,
      closePrice: 3060,
      pnlUsdNet: 60,
      realizedPnlPct: 0.02,
      exitReason: "1차 분할 청산",
      closeSource: "INTERNAL_ENGINE",
      closedAt: Date.now() - 5000
    };
    const norm = normalizeClosedHistoryRow(rawBot);
    assert.equal(norm.symbol, "ETHUSDT");
    assert.equal(norm.side, "long");
    assert.equal(norm.sourceLabel, "자동");
    assert.equal(norm.realizedPnlUsd, 60);
    assert.equal(norm.exitReason, "1차 분할 청산");
  });

  // 13. BTC/ETH 둘 다 표시
  await t.test("13. Both BTC and ETH positions appear together when active", () => {
    const engineState = {
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: true,
      ledger_okx_position_sync: {
        okx_positions_preview: [
          { symbol: "BTCUSDT", side: "long", pos: 1, notionalUsd: 65000 },
          { symbol: "ETHUSDT", side: "short", pos: 10, notionalUsd: 30000 }
        ]
      }
    };
    const openPositions: unknown[] = [];

    const currentPositions = deriveCurrentPositionsForDisplay(engineState, openPositions);
    assert.equal(currentPositions.length, 2);
    const syms = currentPositions.map((p: any) => p.symbol).sort();
    assert.deepEqual(syms, ["BTCUSDT", "ETHUSDT"]);
  });

  // 14. trading behavior unchanged
  await t.test("14. Display logic never mutates orders, signals, or ledger state", () => {
    const inputOpenPositions = [
      Object.freeze({
        symbol: "BTCUSDT",
        side: "long",
        status: "open",
        entryPrice: 65000,
        flowId: "flow-immutable"
      })
    ];
    const engineState = Object.freeze({
      position_source: "okx_actual",
      okx_signed_rest_ready: true,
      okx_positions_ok: true,
      ledger_okx_position_sync: Object.freeze({
        okx_positions_preview: Object.freeze([
          Object.freeze({ symbol: "BTCUSDT", side: "long", pos: 1 })
        ])
      })
    });

    const result = deriveCurrentPositionsForDisplay(engineState, inputOpenPositions as any);
    assert.equal(result.length, 1);
    // Original inputs untouched
    assert.equal((inputOpenPositions[0] as any).flowId, "flow-immutable");
  });
});
