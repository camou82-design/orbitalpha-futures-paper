import type { PaperOpenPositionRecord } from "../models/types";
import { classifyPositionSizeDelta } from "../engine-v2/position/manual-reduce-rebase";
import { evaluateManualOwnershipLatchTrigger } from "../engine-v2/position/manual-ownership-latch";

function assertTrue(v: boolean, label: string): void {
  if (!v) throw new Error(`${label}: expected true`);
}

function assertFalse(v: boolean, label: string): void {
  if (v) throw new Error(`${label}: expected false`);
}

function assertEq<T>(a: T, b: T, label: string): void {
  if (a !== b) throw new Error(`${label}: expected ${String(b)}, got ${String(a)}`);
}

function botLedger(overrides: Partial<PaperOpenPositionRecord> = {}): PaperOpenPositionRecord {
  return {
    symbol: "BTCUSDT",
    side: "long",
    openedAt: 1,
    entryPrice: 64231.9,
    sizeUsd: 13.475,
    okxContracts: 0.21,
    isV2Authority: true,
    authoritySourceAtEntry: "v2",
    exchangeClOrdId: "pbtc001",
    lastBotExecutionAt: Date.now() - 5_000,
    lastBotExecutionReason: "executor_stop_loss",
    ...overrides
  } as PaperOpenPositionRecord;
}

// CASE E — bot reduce 0.02: 0.21 → 0.19 with matching fill evidence
{
  const attr = classifyPositionSizeDelta({
    beforeContracts: 0.21,
    afterContracts: 0.19,
    ledger: botLedger({ partialPendingProcessedContracts: 0.02, lifecycleState: "PARTIAL_PENDING" }),
    botManaged: true,
    nowMs: Date.now()
  });
  assertEq(attr.classification, "BOT_REDUCE_RECONCILE", "CASE E classification");
  const latch = evaluateManualOwnershipLatchTrigger({
    ledger: botLedger(),
    syncStatus: "ALIGNED",
    okxActualContracts: 0.19,
    okxActualPositionExists: true,
    ledgerPaperContracts: 0.21,
    okxFetchReady: true
  });
  assertFalse(latch.shouldLatch, "CASE E no manual latch");
}

// CASE F — no bot evidence + independent manual evidence → manual increase path not bot reduce
{
  const attr = classifyPositionSizeDelta({
    beforeContracts: 0.21,
    afterContracts: 0.19,
    ledger: {
      symbol: "BTCUSDT",
      side: "long",
      manualLifecycleEvidenceIndependent: true
    } as PaperOpenPositionRecord,
    botManaged: false,
    nowMs: Date.now()
  });
  assertEq(attr.classification, "UNKNOWN", "CASE F unknown without bot managed");
}

console.log("bot-reduce-attribution-cases: ALL PASS");
